//! Between the entities and the routes' JSON (ADR DATA-019): a model as
//! Drizzle returned the row (the entity serializes it, `numeric` as text with
//! its column's scale, `Date`s as `toISOString()`), and the values the routes
//! used to bind as text and cast (`$n::timestamp`, `$n::date`,
//! `$n::numeric`) as the entities' own types.

use std::str::FromStr;

use sea_orm::DbErr;
use sea_orm::prelude::BigDecimal;
use time::macros::format_description;
use time::{Date, OffsetDateTime, PrimitiveDateTime};

/// A model as Drizzle returned the row (`serde_json::to_value`); a failure
/// is the statement's (`DbErr::Json`).
macro_rules! js {
    ($model:expr) => {
        serde_json::to_value($model).map_err(|error| sea_orm::DbErr::Json(error.to_string()))
    };
}

/// [`js!`] of every model, in order.
macro_rules! js_rows {
    ($models:expr) => {
        $models
            .into_iter()
            .map(|model| $crate::rows::js!(model))
            .collect::<Result<Vec<serde_json::Value>, sea_orm::DbErr>>()
    };
}

pub(crate) use {js, js_rows};

/// `new Date()` once: the ISO text the route puts in its JSON and events,
/// and the `timestamp` it stores (UTC, milliseconds, as Drizzle wrote it).
pub(crate) fn now_and_stamp() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (
        weldsuite_events::iso_timestamp(at),
        weldsuite_db::utc_timestamp(at),
    )
}

/// `$n::timestamp` of milliseconds since the epoch, written as
/// `toISOString()`: the UTC wall clock.
pub(crate) fn timestamp_of_millis(millis: i64) -> Result<PrimitiveDateTime, DbErr> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .map(weldsuite_db::utc_timestamp)
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type timestamp: {millis}")))
}

/// `$n::timestamp` of an ISO timestamp the route wrote (`toISOString()`):
/// Postgres keeps its wall clock and drops the `Z`; else the failed cast's
/// error (the route's 500).
pub(crate) fn timestamp_of_iso(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    weldsuite_books_domain::js::js_date_millis(iso)
        .ok_or_else(|| {
            DbErr::Type(format!(
                "invalid input syntax for type timestamp: \"{iso}\""
            ))
        })
        .and_then(timestamp_of_millis)
}

/// `$n::date` of a `YYYY-MM-DD` day, or the failed cast's error.
pub(crate) fn date_of(day: &str) -> Result<Date, DbErr> {
    Date::parse(day, format_description!("[year]-[month]-[day]"))
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type date: \"{day}\"")))
}

/// `$n::numeric` of the decimal text the route wrote (`toFixed(2)`), or
/// the failed cast's error.
pub(crate) fn decimal_of(text: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(text)
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type numeric: \"{text}\"")))
}

/// `amount::text` of a `numeric(p, 2)` column: Postgres prints its two
/// decimals (the entities' serializer).
pub(crate) fn money_text(amount: &BigDecimal) -> String {
    amount.with_scale(2).to_plain_string()
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
        assert_eq!(
            timestamp_of_millis(0).ok(),
            Some(datetime!(1970-01-01 00:00:00))
        );
        assert_eq!(date_of("2026-02-28").ok(), Some(date!(2026 - 02 - 28)));
        assert!(date_of("2026-02-30").is_err());
        assert_eq!(
            decimal_of("12.30").ok().map(|d| money_text(&d)),
            Some("12.30".to_owned())
        );
    }
}
