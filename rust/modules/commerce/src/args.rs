//! The cursor-paged list of the products route, and the pieces the
//! statements share: the timestamps they bind and Postgres's own clock.
//!
//! A list pushes its conditions in the TypeScript route's order: each one
//! is a slot that is on or off (a typed condition on the entity's columns),
//! and its count drops the last one that is on when a `?cursor=` was given
//! ([`sliced`]).

use std::str::FromStr;

use axum::response::{IntoResponse, Response};
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Alias, Expr, Func, IntoIden, Query, SelectStatement};
use sea_orm::{
    ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait, QueryFilter, QuerySelect,
};
use serde_json::Value;
use time::PrimitiveDateTime;
use weldsuite_db::{PgPool, orm};
use weldsuite_schema::tenant::commerce_channel_keys;

use crate::table::Table;

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

/// A `timestamp` as `toISOString()` writes it (`to_jsonb(t.created_at)`
/// read back as JavaScript does).
pub(crate) fn iso(at: PrimitiveDateTime) -> String {
    weldsuite_events::iso_timestamp(at.assume_utc())
}

/// [`iso`] of a nullable column, `null` for none.
pub(crate) fn iso_or_null(at: Option<PrimitiveDateTime>) -> Value {
    at.map_or(Value::Null, |at| Value::String(iso(at)))
}

/// An amount in cents as the `numeric` value its text (`money::format`)
/// was cast to.
pub(crate) fn decimal(cents: weldsuite_commerce_domain::money::Cents) -> BigDecimal {
    BigDecimal::from_str(&weldsuite_commerce_domain::money::format(cents)).unwrap_or_default()
}

/// `now() at time zone 'utc'`: the database's clock, as the statements that
/// stamp a row with it read it.
pub(crate) fn utc_now_sql() -> Expr {
    Func::cust("timezone")
        .arg(Expr::val("utc"))
        .arg(Func::cust("now"))
        .into()
}

/// `select pg_advisory_xact_lock(hashtext(key))`: serialise with every other
/// holder of `key` until the transaction ends.
pub(crate) async fn advisory_lock<C: ConnectionTrait>(db: &C, key: &str) -> Result<(), DbErr> {
    let mut lock = Query::select();
    lock.expr(Func::cust("pg_advisory_xact_lock").arg(Func::cust("hashtext").arg(key)));
    db.execute(&lock).await.map(|_| ())
}

/// `select <condition>`: one boolean the database works out (`exists (…) or
/// exists (…)`).
pub(crate) async fn select_bool<C: ConnectionTrait>(
    db: &C,
    condition: Expr,
) -> Result<bool, DbErr> {
    let mut select = Query::select();
    select.expr_as(condition, Alias::new("value"));
    let row = db
        .query_one(&select)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("select".to_owned()))?;
    row.try_get("", "value")
}

/// `allowed_origins->>0` of a storefront key in `table` (its name or alias).
pub(crate) fn first_origin(table: impl IntoIden) -> Expr {
    sea_orm::sea_query::extension::postgres::PgExpr::cast_json_field(
        Expr::col((table, commerce_channel_keys::Column::AllowedOrigins)),
        0,
    )
}

/// A live publishable key that allows an origin: `kind = 'publishable' and
/// revoked_at is null and jsonb_typeof(allowed_origins) = 'array' and
/// jsonb_array_length(allowed_origins) > 0`, the key in `table`.
pub(crate) fn has_origin(table: impl IntoIden) -> Condition {
    let table = table.into_iden();
    let column = |column: commerce_channel_keys::Column| Expr::col((table.clone(), column));
    let origins = || column(commerce_channel_keys::Column::AllowedOrigins);
    Condition::all()
        .add(sea_orm::ExprTrait::eq(
            column(commerce_channel_keys::Column::Kind),
            "publishable",
        ))
        .add(sea_orm::ExprTrait::is_null(column(
            commerce_channel_keys::Column::RevokedAt,
        )))
        .add(sea_orm::ExprTrait::eq(
            Func::cust("jsonb_typeof").arg(origins()),
            "array",
        ))
        .add(sea_orm::ExprTrait::gt(
            Func::cust("jsonb_array_length").arg(origins()),
            0,
        ))
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
pub(crate) fn before<C: ColumnTrait>(
    created_at: C,
    id: C,
    (at, cursor_id): &CursorRow,
) -> Condition {
    Condition::any().add(created_at.lt(*at)).add(
        Condition::all()
            .add(created_at.eq(*at))
            .add(id.lt(cursor_id.as_str())),
    )
}

/// `not exists (select 1 from t where id = cursor) or (t.key, t.id) <|>
/// (select c.key, c.id from t c where c.id = cursor)`: the rows after the
/// cursor row in a keyset order (descending: `<`), every row when the
/// cursor row is gone.
pub(crate) fn after_cursor<E: EntityTrait>(
    key: E::Column,
    id: E::Column,
    cursor: &str,
    descending: bool,
) -> Condition {
    let row = Alias::new("c");
    let gone = Query::select()
        .expr(Expr::val(1))
        .from(E::default())
        .and_where(id.eq(cursor))
        .to_owned();
    let at = Query::select()
        .column((row.clone(), key))
        .column((row.clone(), id))
        .from_as(E::default(), row.clone())
        .and_where(sea_orm::ExprTrait::eq(Expr::col((row, id)), cursor))
        .to_owned();
    let here = Expr::tuple([
        Expr::col((E::default(), key)),
        Expr::col((E::default(), id)),
    ]);
    let after = if descending {
        sea_orm::ExprTrait::lt(here, at)
    } else {
        sea_orm::ExprTrait::gt(here, at)
    };
    Condition::any().add(Expr::not_exists(gone)).add(after)
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

#[cfg(test)]
mod tests {
    use sea_orm::sea_query::{PostgresQueryBuilder, Query};

    use super::*;

    #[test]
    fn the_database_clock_reads_as_utc() {
        let mut select = Query::select();
        select.expr(utc_now_sql());
        assert_eq!(
            select.to_string(PostgresQueryBuilder),
            "SELECT timezone('utc', now())"
        );
    }

    /// The rows after the cursor's in a keyset order, every row when the
    /// cursor's row is gone.
    #[test]
    fn a_cursor_compares_the_keyset_with_its_row() {
        use sea_orm::{DbBackend, QueryTrait};
        use weldsuite_schema::tenant::discounts;
        let statement = discounts::Entity::find()
            .select_only()
            .column(discounts::Column::Id)
            .filter(after_cursor::<discounts::Entity>(
                discounts::Column::CreatedAt,
                discounts::Column::Id,
                "disc_1",
                true,
            ))
            .build(DbBackend::Postgres);
        assert_eq!(
            statement.sql,
            r#"SELECT "discounts"."id" FROM "discounts" WHERE (NOT EXISTS(SELECT $1 FROM "discounts" WHERE "discounts"."id" = $2)) OR ("discounts"."created_at", "discounts"."id") < (SELECT "c"."created_at", "c"."id" FROM "discounts" AS "c" WHERE "c"."id" = $3)"#
        );
    }

    #[test]
    fn a_count_drops_the_last_condition_on_a_cursor() {
        assert_eq!(
            sliced(vec![true, false, true, false], true),
            [true, false, false, false]
        );
        assert_eq!(sliced(vec![true, true], false), [true, true]);
    }
}
