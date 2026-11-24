//! What the tax filings' SeaORM queries share (ADR DATA-019):
//!
//! - [`to_json`]: a row as Drizzle's `select()` returned it.
//! - the values the routes used to bind as text and cast (`$n::timestamp`,
//!   `$n::date`, `$n::numeric`) as the entities' own types, and the text the
//!   old statements read back (`numeric::text`, `to_char(…)`).

use std::str::FromStr;

use sea_orm::DbErr;
use sea_orm::prelude::BigDecimal;
use sea_orm::sea_query::{Expr, IntoColumnRef};
use serde_json::Value;
use time::macros::format_description;
use time::{Date, OffsetDateTime, PrimitiveDateTime};

/// A row as Drizzle's `select()` returns it: the entity's model serializes
/// to that JSON (`numeric` as its text with the column's scale, `Date`s as
/// `toISOString()`); a failure is the statement's.
pub(crate) fn to_json(model: impl serde::Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// [`to_json`] of every row, in order.
pub(crate) fn to_json_rows<M: serde::Serialize>(models: Vec<M>) -> Result<Vec<Value>, DbErr> {
    models.into_iter().map(to_json).collect()
}

/// `new Date()` once: the ISO text the route puts in its JSON and events,
/// and the `timestamp` it stores (UTC, milliseconds, as Drizzle wrote it).
pub(crate) fn now_and_stamp() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (
        weldsuite_events::iso_timestamp(at),
        weldsuite_db::utc_timestamp(at),
    )
}

/// `$n::timestamp` of an ISO instant the route wrote (`toISOString()`):
/// Postgres keeps its UTC wall clock and drops the `Z`. What it can't read
/// is the failed cast's error (the route's 500).
pub(crate) fn timestamp_of_iso(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    weldsuite_books_domain::js::js_date_millis(iso)
        .and_then(|millis| {
            OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000).ok()
        })
        .map(weldsuite_db::utc_timestamp)
        .ok_or_else(|| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{iso}\""
            ))
        })
}

/// `$n::date` of a `YYYY-MM-DD` day, or the failed cast's error.
pub(crate) fn date_of(day: &str) -> Result<Date, DbErr> {
    Date::parse(day, format_description!("[year]-[month]-[day]"))
        .ok()
        .filter(|date| date.year() >= 1)
        .ok_or_else(|| DbErr::Type(format!("invalid input syntax for type date: \"{day}\"")))
}

/// `$n::numeric` of the decimal text the route wrote (`toFixed(2)`): the
/// value with that text's scale, or the failed cast's error.
pub(crate) fn decimal_of(text: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(text)
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type numeric: \"{text}\"")))
}

/// A `timestamp` as Drizzle returned it in `date` mode: `toISOString()`.
pub(crate) fn iso_of(at: PrimitiveDateTime) -> String {
    match weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer) {
        Ok(Value::String(text)) => text,
        _ => String::new(),
    }
}

/// `to_char(at, 'YYYY-MM-DD')` of a `timestamp`.
pub(crate) fn day_of(at: PrimitiveDateTime) -> String {
    match weldsuite_schema::js::date::serialize(&at.date(), serde_json::value::Serializer) {
        Ok(Value::String(text)) => text,
        _ => String::new(),
    }
}

/// `expr::text`: a `numeric` as Postgres prints it, for the readers that
/// take the text as JavaScript did (`Number(text)`, `parseFloat`).
pub(crate) fn text_of(expr: impl Into<Expr>) -> Expr {
    sea_orm::ExprTrait::cast_as(expr.into(), "text")
}

/// `column::text`, see [`text_of`].
pub(crate) fn column_text(column: impl IntoColumnRef) -> Expr {
    text_of(Expr::col(column))
}

#[cfg(test)]
mod tests {
    use time::macros::{date, datetime};

    use super::*;

    #[test]
    fn values_bind_as_the_casts_read_them() {
        assert_eq!(
            timestamp_of_iso("2026-10-29T07:00:00.123Z").ok(),
            Some(datetime!(2026-10-29 07:00:00.123))
        );
        assert!(timestamp_of_iso("nope").is_err());
        assert_eq!(date_of("2026-02-28").ok(), Some(date!(2026 - 02 - 28)));
        assert!(date_of("2026-02-30").is_err());
        assert_eq!(
            decimal_of("12.30").ok().map(|d| d.to_plain_string()),
            Some("12.30".to_owned())
        );
        assert_eq!(
            iso_of(datetime!(2026-10-29 07:00:00.123_456)),
            "2026-10-29T07:00:00.123Z"
        );
        assert_eq!(day_of(datetime!(2026-03-04 23:59:59)), "2026-03-04");
    }
}
