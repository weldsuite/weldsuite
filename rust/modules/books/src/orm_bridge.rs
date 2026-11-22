//! What the ledger's SeaORM queries share (ADR DATA-019):
//!
//! - [`sqlx_error`]: the way back from SeaORM's error to sqlx's, for
//!   `weldsuite_books_domain::http::Refusal` (`Refusal::Database` holds an
//!   `sqlx::Error`) and the `atomically_with` closures that also run the
//!   domain crate's table writes. It exists only until
//!   `weldsuite-books-domain` is converted to the ORM and its `Refusal` holds
//!   a `sea_orm::DbErr`; then it goes.
//! - [`to_json`]: a row as Drizzle's `select()` returned it.
//! - [`pg_date`]: a `YYYY-MM-DD` text as the old statements' `$n::date`
//!   cast read it.
//! - [`select_flags`]: `select exists (…), …` without a table.

use std::sync::Arc;

use sea_orm::sea_query::{Alias, Expr, Query};
use sea_orm::{ConnectionTrait, DbErr, RuntimeErr};
use serde_json::Value;
use time::Date;
use time::macros::format_description;

/// The `sqlx::Error` inside `error` when SeaORM ran the statement through
/// sqlx (and nothing else holds it), else a protocol error carrying its text.
pub(crate) fn sqlx_error(error: DbErr) -> sqlx::Error {
    match error {
        DbErr::Conn(RuntimeErr::SqlxError(inner))
        | DbErr::Exec(RuntimeErr::SqlxError(inner))
        | DbErr::Query(RuntimeErr::SqlxError(inner)) => {
            Arc::try_unwrap(inner).unwrap_or_else(|shared| sqlx::Error::Protocol(shared.to_string()))
        }
        other => sqlx::Error::Protocol(other.to_string()),
    }
}

/// A row as Drizzle's `select()` returns it: the entity's model (or a
/// `FromQueryResult` row) serializes to that JSON, `numeric` as its text.
pub(crate) fn to_json(model: impl serde::Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `'<text>'::date`: the day of a `YYYY-MM-DD` text, or the error Postgres
/// raised for it (year 0 included, which Postgres has no day of), so the
/// route still answers its 500.
pub(crate) fn pg_date(text: &str) -> Result<Date, DbErr> {
    Date::parse(text, format_description!("[year]-[month]-[day]"))
        .ok()
        .filter(|day| day.year() >= 1)
        .ok_or_else(|| DbErr::Custom(format!("invalid input syntax for type date: \"{text}\"")))
}

/// `select <check>, …` without a table (the `exists (…)` checks): each
/// check's answer, in order.
pub(crate) async fn select_flags<C: ConnectionTrait, const N: usize>(
    db: &C,
    checks: [Expr; N],
) -> Result<[bool; N], DbErr> {
    let mut select = Query::select();
    for (at, check) in checks.into_iter().enumerate() {
        select.expr_as(check, Alias::new(format!("f{at}")));
    }
    let row = db
        .query_one(&select)
        .await?
        .ok_or_else(|| DbErr::RecordNotFound("select returned no row".to_owned()))?;
    let mut flags = [false; N];
    for (at, flag) in flags.iter_mut().enumerate() {
        *flag = row.try_get("", &format!("f{at}"))?;
    }
    Ok(flags)
}
