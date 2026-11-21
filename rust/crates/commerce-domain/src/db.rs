//! The order writes on the SeaORM entities of `weldsuite-schema` (ADR
//! DATA-019), on the caller's connection: [`on`] makes it a SeaORM one for
//! one statement, so an ORM statement joins the caller's transaction and the
//! public functions keep taking `&mut PgConnection`.
//!
//! Money columns are `numeric` (`BigDecimal` in the entities) and cents
//! here ([`decimal`], [`cents`]); timestamps are `timestamp` without a zone,
//! written with milliseconds as Drizzle's `new Date()` ([`now`]).

use std::str::FromStr;
use std::sync::Arc;

use sea_orm::prelude::BigDecimal;
use sea_orm::{DbErr, RuntimeErr};
use sqlx::PgConnection;
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::OrmConn;

use crate::money::{self, Cents};

/// `conn` as a SeaORM connection for the statements awaited on it.
pub(crate) fn on(conn: &mut PgConnection) -> OrmConn<'_> {
    OrmConn::new(conn)
}

/// A failed sqlx statement as the error the ORM ones give, so a caller sees
/// one error type and can still read the database's code and constraint.
#[must_use]
pub fn from_sqlx(error: sqlx::Error) -> DbErr {
    DbErr::Query(RuntimeErr::SqlxError(Arc::new(error)))
}

/// The constraint a failed statement broke, when the database named one.
#[must_use]
pub fn constraint_of(error: &DbErr) -> Option<String> {
    match error {
        DbErr::Exec(RuntimeErr::SqlxError(error)) | DbErr::Query(RuntimeErr::SqlxError(error)) => {
            error
                .as_database_error()
                .and_then(|error| error.constraint())
                .map(str::to_owned)
        }
        _ => None,
    }
}

/// The database's own message for a failed statement (no driver prefix),
/// else the error as text.
#[must_use]
pub fn message_of(error: &DbErr) -> String {
    match error {
        DbErr::Exec(RuntimeErr::SqlxError(inner)) | DbErr::Query(RuntimeErr::SqlxError(inner)) => {
            match inner.as_database_error() {
                Some(database) => database.message().to_owned(),
                None => inner.to_string(),
            }
        }
        other => other.to_string(),
    }
}

/// The failed statement broke a unique index or constraint.
#[must_use]
pub fn is_unique_violation(error: &DbErr) -> bool {
    matches!(
        error.sql_err(),
        Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
    )
}

/// `cents` as a `numeric(…, 2)` value.
pub(crate) fn decimal(cents: Cents) -> BigDecimal {
    BigDecimal::from_str(&money::format(cents)).unwrap_or_default()
}

/// A `numeric` amount in cents (rounded half away from zero past the cent,
/// as `money::parse` reads the text Postgres gives).
pub(crate) fn cents(value: &BigDecimal) -> Cents {
    let text = value.to_plain_string();
    match text.strip_prefix('-') {
        Some(magnitude) => -money::parse(magnitude).unwrap_or_default(),
        None => money::parse(&text).unwrap_or_default(),
    }
}

/// [`cents`] of a nullable column, zero for none.
pub(crate) fn cents_or_zero(value: Option<&BigDecimal>) -> Cents {
    value.map_or(0, cents)
}

/// `new Date()` as Drizzle writes it to a `timestamp` column: UTC, to the
/// millisecond.
pub(crate) fn now() -> PrimitiveDateTime {
    let now = OffsetDateTime::now_utc();
    let millis = now.millisecond();
    let now = now.replace_millisecond(millis).unwrap_or(now);
    PrimitiveDateTime::new(now.date(), now.time())
}

/// Serialise with every other holder of `key` until the transaction ends
/// (`pg_advisory_xact_lock`): first uses that would each create a row.
///
/// # Errors
/// A failed statement.
#[allow(
    clippy::disallowed_methods,
    reason = "an advisory lock is a function call, not a table: no entity expresses it"
)]
pub(crate) async fn advisory_lock(conn: &mut PgConnection, key: &str) -> Result<(), DbErr> {
    sqlx::query("select pg_advisory_xact_lock(hashtext($1))")
        .bind(key)
        .execute(&mut *conn)
        .await
        .map(|_| ())
        .map_err(from_sqlx)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn money_round_trips_through_numeric() {
        for amount in [0, 1, 99, 100, 123_456, -250] {
            assert_eq!(cents(&decimal(amount)), amount);
        }
        assert_eq!(
            BigDecimal::from_str("12.5").ok().as_ref().map(cents),
            Some(1250)
        );
    }

    #[test]
    fn now_is_to_the_millisecond() {
        assert_eq!(now().nanosecond() % 1_000_000, 0);
    }
}
