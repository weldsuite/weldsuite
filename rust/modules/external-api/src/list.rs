//! Cursor lists (`lib/list-helpers.ts`, `lib/pagination.ts`): newest first
//! on `(created_at, id)`, the cursor is the last row's id, and a cursor that
//! names no row starts from the first page.
//!
//! A list is a table's entity ([`JsonTable`]) and its conditions, built from
//! the list's filters object: the request's query, read into
//! `{ key: value | null }` (a `null` filter is not applied, as the routes'
//! `if (q.key)` leaves it out). The helpers here read that object the way
//! the routes read their query ([`when`], [`when_flag`], [`always`]).

use axum::Json;
use axum::response::{IntoResponse, Response};
use sea_orm::sea_query::{Alias, Expr, Func, Order, Query, SelectStatement};
use sea_orm::{ColumnTrait, Condition, DbErr};
use serde_json::{Value, json};
use weldsuite_db::PgPool;
use weldsuite_db::record::JsonTable;
use weldsuite_kit::ApiError;
use weldsuite_kit::validation::{Issues, Number, Presence, query_values};

use crate::session::database_error;

/// `DEFAULT_LIMIT` and `MAX_LIMIT` of `lib/pagination.ts`.
pub(crate) const DEFAULT_LIMIT: i64 = 50;
/// (`MAX_LIMIT`, as the float the validator and the clamp compare with.)
const MAX_LIMIT_F64: f64 = 200.0;

/// A list's conditions on its table, from its filters object.
pub(crate) type Filter = fn(&Value) -> Condition;

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
                    max: Some(MAX_LIMIT_F64),
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
            let n = n.floor().min(MAX_LIMIT_F64) as i64;
            n
        }
        _ => DEFAULT_LIMIT,
    }
}

/// A filter's value as text (`$3->>'key'`), `None` when it is null or
/// missing.
pub(crate) fn param(filters: &Value, key: &str) -> Option<String> {
    match filters.get(key)? {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        other => Some(other.to_string()),
    }
}

/// `($3->>'key' is null or <test>)`: `test` on the filter's value when it is
/// set, nothing otherwise.
pub(crate) fn when<C: Into<Condition>>(
    filters: &Value,
    key: &str,
    test: impl FnOnce(String) -> C,
) -> Option<Condition> {
    param(filters, key).map(|value| test(value).into())
}

/// `($3->>'key' is null or <test>)` on a boolean filter
/// (`($3->>'key')::boolean`): the lists set these from `q.flag !== undefined`.
pub(crate) fn when_flag<C: Into<Condition>>(
    filters: &Value,
    key: &str,
    test: impl FnOnce(bool) -> C,
) -> Option<Condition> {
    filters
        .get(key)
        .and_then(Value::as_bool)
        .map(|flag| test(flag).into())
}

/// `<test>` on a filter the list always has (`t.zone_id = $3->>'zoneId'`):
/// without it, nothing matches (`= null`).
pub(crate) fn always<C: Into<Condition>>(
    filters: &Value,
    key: &str,
    test: impl FnOnce(String) -> C,
) -> Condition {
    param(filters, key).map_or_else(Condition::any, |value| test(value).into())
}

/// `t.<column> like $pattern or …`: the pattern on any of the columns.
pub(crate) fn like_any<C: ColumnTrait>(columns: &[C], pattern: &str) -> Condition {
    columns
        .iter()
        .fold(Condition::any(), |any, column| any.add(column.like(pattern)))
}

/// `t.<enum column>::text = $value`: an enum compared by its label, so a
/// label that is not one of the type's matches nothing.
pub(crate) fn label_eq<C: ColumnTrait>(column: C, value: String) -> Expr {
    use sea_orm::ExprTrait as _;
    column
        .select_enum_as(Expr::col(column.as_column_ref()))
        .eq(value)
}

/// `$value::<type>`: a filter's text as Postgres reads it into the
/// column's type (`($3->>'dueFrom')::timestamp`).
pub(crate) fn cast(value: String, to: &'static str) -> Expr {
    use sea_orm::ExprTrait as _;
    Expr::val(value).cast_as(to)
}

/// `t.<column> in (select jsonb_array_elements_text($3->'key'))`: the
/// column is one of the filter's strings (none: nothing matches).
pub(crate) fn one_of<C: ColumnTrait>(filters: &Value, key: &str, column: C) -> Condition {
    let values: Vec<String> = filters
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| match item {
                    Value::String(text) => text.clone(),
                    other => other.to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    if values.is_empty() {
        return Condition::any();
    }
    Condition::all().add(column.is_in(values))
}

/// `t.<name>` of a list's table.
fn column(table: &str, name: &str) -> Expr {
    Expr::col((Alias::new(table), Alias::new(name)))
}

/// The page after the cursor row, newest first: `t.created_at <` the cursor
/// row's millisecond, or the same millisecond and a smaller id. A cursor
/// that names no row adds nothing (the first page).
///
/// The cursor row is read in the statement itself, as the `cursor_row` of
/// the worker's query: `(select date_trunc('milliseconds', created_at) from t
/// where id = $cursor limit 1)`.
fn after_cursor(table: &str, cursor: &str) -> Condition {
    use sea_orm::ExprTrait as _;
    let cursor_row = Alias::new("cursor_row");
    let lookup = |select: Expr| {
        Query::select()
            .expr(select)
            .from_as(Alias::new(table), cursor_row.clone())
            .and_where(Expr::col((cursor_row.clone(), Alias::new("id"))).eq(cursor))
            .limit(1)
            .to_owned()
    };
    let at = || {
        Expr::from(lookup(
            Func::cust("date_trunc")
                .arg("milliseconds")
                .arg(Expr::col((cursor_row.clone(), Alias::new("created_at"))))
                .into(),
        ))
    };
    let created_at = column(table, "created_at");
    Condition::any()
        .add(Expr::exists(lookup(Expr::val(1))).not())
        .add(created_at.clone().lt(at()))
        .add(
            Condition::all()
                .add(created_at.eq(at()))
                .add(column(table, "id").lt(cursor)),
        )
}

/// One page of the rows `select` reads from `table` under `condition`: the
/// cursor, newest first, `limit + 1` rows (to see whether there are more).
pub(crate) fn page_statement(
    mut select: SelectStatement,
    table: &str,
    condition: Condition,
    query: &ListQuery,
) -> SelectStatement {
    select.cond_where(condition);
    if let Some(cursor) = query.cursor.as_deref() {
        select.cond_where(after_cursor(table, cursor));
    }
    select
        .order_by_expr(column(table, "created_at"), Order::Desc)
        .order_by_expr(column(table, "id"), Order::Desc)
        .limit(u64::try_from(query.limit + 1).unwrap_or(0));
    select
}

/// One page of a list, before the answer is built (a route that decorates
/// the page as a whole: `withProjectStats`).
pub(crate) struct Page {
    pub(crate) rows: Vec<Value>,
    pub(crate) total: i64,
    pub(crate) has_more: bool,
    pub(crate) cursor: Value,
}

impl Page {
    /// The page of `limit + 1` probed rows and the count: the extra row says
    /// there are more, and the last row kept is the next cursor.
    pub(crate) fn of(mut rows: Vec<Value>, total: i64, limit: i64) -> Self {
        let limit = usize::try_from(limit).unwrap_or(usize::MAX);
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
        Self {
            rows,
            total,
            has_more,
            cursor,
        }
    }

    /// `list(c, data, cursorPagination(total, hasMore, cursor))`.
    pub(crate) fn respond(self) -> Response {
        Json(json!({
            "data": self.rows,
            "pagination": { "totalCount": self.total, "hasMore": self.has_more, "cursor": self.cursor },
        }))
        .into_response()
    }
}

/// The rows of one page of `table` under `condition` (as Drizzle returns
/// them), then the count of every row the condition matches.
pub(crate) async fn list_rows(
    db: &PgPool,
    table: &JsonTable,
    condition: Condition,
    query: &ListQuery,
) -> Result<Page, ApiError> {
    let read = async {
        let db = weldsuite_db::orm(db);
        let page = page_statement(table.select(), table.table_name(), condition.clone(), query);
        let rows = table.rows(&db, &page).await?;
        let mut counted = table.select();
        counted.cond_where(condition);
        let total = table.count(&db, &counted).await?;
        Ok::<_, DbErr>((rows, total))
    };
    let (rows, total) = read.await.map_err(|error| database_error(&error))?;
    Ok(Page::of(rows, total, query.limit))
}

/// One page of a list as `list(c, data, cursorPagination(...))` answers it.
pub(crate) async fn list_page(
    db: &PgPool,
    table: &JsonTable,
    condition: Condition,
    query: &ListQuery,
) -> Result<Response, ApiError> {
    Ok(list_rows(db, table, condition, query).await?.respond())
}

/// [`list_page`] with each row mapped (`mapRow`).
pub(crate) async fn list_page_mapped(
    db: &PgPool,
    table: &JsonTable,
    condition: Condition,
    query: &ListQuery,
    map: impl Fn(Value) -> Value,
) -> Result<Response, ApiError> {
    let mut page = list_rows(db, table, condition, query).await?;
    page.rows = page.rows.into_iter().map(map).collect();
    Ok(page.respond())
}

#[cfg(test)]
mod tests {
    use sea_orm::DbBackend;

    use super::*;

    #[test]
    fn limits_clamp_like_clamp_limit() {
        assert_eq!(clamp_limit(None), 50);
        assert_eq!(clamp_limit(Some(0.0)), 50);
        assert_eq!(clamp_limit(Some(7.9)), 7);
        assert_eq!(clamp_limit(Some(500.0)), 200);
    }

    #[test]
    fn a_page_starts_after_the_cursor_row_newest_first() {
        let table = crate::tables_gen::PROJECT_GOALS.entity;
        let query = ListQuery {
            cursor: Some("goal_1".into()),
            limit: 2,
        };
        let page = page_statement(
            Query::select()
                .column(Alias::new("id"))
                .from(Alias::new("project_goals"))
                .to_owned(),
            table.table_name(),
            Condition::all().add(column("project_goals", "deleted_at").is_null()),
            &query,
        );
        let sql = DbBackend::Postgres.build(&page).sql;
        assert_eq!(
            sql,
            concat!(
                r#"SELECT "id" FROM "project_goals" WHERE "project_goals"."deleted_at" IS NULL AND "#,
                r#"(NOT EXISTS(SELECT $1 FROM "project_goals" AS "cursor_row" WHERE "cursor_row"."id" = $2 LIMIT $3) "#,
                r#"OR "project_goals"."created_at" < (SELECT date_trunc($4, "cursor_row"."created_at") FROM "project_goals" AS "cursor_row" WHERE "cursor_row"."id" = $5 LIMIT $6) "#,
                r#"OR ("project_goals"."created_at" = (SELECT date_trunc($7, "cursor_row"."created_at") FROM "project_goals" AS "cursor_row" WHERE "cursor_row"."id" = $8 LIMIT $9) "#,
                r#"AND "project_goals"."id" < $10)) "#,
                r#"ORDER BY "project_goals"."created_at" DESC, "project_goals"."id" DESC LIMIT $11"#
            )
        );
    }

    #[test]
    fn filters_read_like_the_query() {
        let filters = json!({ "a": "x", "b": null, "c": true, "n": 3 });
        assert_eq!(param(&filters, "a").as_deref(), Some("x"));
        assert_eq!(param(&filters, "b"), None);
        assert_eq!(param(&filters, "missing"), None);
        assert_eq!(param(&filters, "n").as_deref(), Some("3"));
        assert!(when(&filters, "b", |_| Condition::all()).is_none());
        assert!(when_flag(&filters, "c", |_| Condition::all()).is_some());
        assert!(when_flag(&filters, "a", |_| Condition::all()).is_none());
    }

    #[test]
    fn pages_probe_one_row_more() {
        let rows = vec![json!({ "id": "a" }), json!({ "id": "b" }), json!({ "id": "c" })];
        let page = Page::of(rows.clone(), 9, 2);
        assert!(page.has_more);
        assert_eq!(page.cursor, json!("b"));
        assert_eq!(page.rows.len(), 2);
        let last = Page::of(rows, 3, 3);
        assert!(!last.has_more);
        assert_eq!(last.cursor, Value::Null);
    }
}
