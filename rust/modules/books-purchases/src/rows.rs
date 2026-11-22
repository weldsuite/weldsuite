//! Between the entities and the routes' JSON (ADR DATA-019): a model as
//! Drizzle returned the row (the entity serializes it, `numeric` as text with
//! its column's scale, `Date`s as `toISOString()`), and the values the routes
//! used to bind as text and cast (`$n::timestamp`, `$n::date`,
//! `$n::numeric`) as the entities' own types.

use std::str::FromStr;

use sea_orm::DbErr;
use sea_orm::prelude::BigDecimal;
use serde_json::Value;
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
pub(crate) fn timestamp_of_millis(millis: i64) -> Option<PrimitiveDateTime> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(millis) * 1_000_000)
        .ok()
        .map(weldsuite_db::utc_timestamp)
}

/// `$n::timestamp` of an ISO timestamp the route wrote (`toISOString()`):
/// Postgres keeps its wall clock and drops the `Z`.
pub(crate) fn timestamp_of_iso(iso: &str) -> Option<PrimitiveDateTime> {
    weldsuite_books_domain::js::js_date_millis(iso).and_then(timestamp_of_millis)
}

/// [`timestamp_of_iso`], or the failed cast's error (the route's 500).
pub(crate) fn timestamp_or_err(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    timestamp_of_iso(iso).ok_or_else(|| {
        DbErr::Type(format!(
            "invalid input syntax for type timestamp: \"{iso}\""
        ))
    })
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

/// A count or setting bound to an `integer` column, or Postgres's refusal
/// of a value out of its range.
pub(crate) fn int4(value: i64) -> Result<i32, DbErr> {
    i32::try_from(value).map_err(|_| DbErr::Type("integer out of range".to_owned()))
}

/// `amount::text` of a `numeric(18, 2)` column: Postgres prints its two
/// decimals (the entity's serializer).
pub(crate) fn money_text(amount: &BigDecimal) -> String {
    amount.with_scale(2).to_plain_string()
}

/// `to_char(at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` of a `timestamp`: its ISO
/// text, as `toISOString()` writes it.
pub(crate) fn iso_of(at: PrimitiveDateTime) -> String {
    match weldsuite_schema::js::timestamp::serialize(&at, serde_json::value::Serializer) {
        Ok(Value::String(text)) => text,
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use time::macros::{date, datetime};

    use super::*;

    #[test]
    fn values_bind_as_the_casts_read_them() {
        assert_eq!(
            timestamp_of_iso("2026-10-29T07:00:00.123Z"),
            Some(datetime!(2026-10-29 07:00:00.123))
        );
        assert_eq!(date_of("2026-02-28").ok(), Some(date!(2026 - 02 - 28)));
        assert!(date_of("2026-02-30").is_err());
        assert_eq!(
            decimal_of("12.30").ok().map(|d| money_text(&d)),
            Some("12.30".to_owned())
        );
        assert_eq!(
            iso_of(datetime!(2026-10-29 07:00:00.123_456)),
            "2026-10-29T07:00:00.123Z"
        );
    }
}
