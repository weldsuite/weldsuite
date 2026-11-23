//! What the posting and ledger queries share now that they go through the
//! SeaORM entities (ADR DATA-019):
//!
//! - [`to_json`]: a row as Drizzle's `select()` returned it (the entity's
//!   model serializes to that JSON: `numeric` as its text, `Date`s as
//!   `toISOString()`).
//! - the values the old statements bound as text and cast (`$n::date`,
//!   `$n::timestamp`, `$n::numeric`) as the entities' own types; text the
//!   cast refused is that cast's error, so the route still answers its 500.

use std::str::FromStr;

use sea_orm::DbErr;
use sea_orm::prelude::BigDecimal;
use serde_json::Value;
use time::macros::format_description;
use time::{Date, OffsetDateTime, PrimitiveDateTime};

/// A row as Drizzle's `select()` returns it; a failure is the statement's.
pub(crate) fn to_json(model: impl serde::Serialize) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// [`to_json`] of every row, in order.
pub(crate) fn to_json_rows<M: serde::Serialize>(models: Vec<M>) -> Result<Vec<Value>, DbErr> {
    models.into_iter().map(to_json).collect()
}

/// `new Date()` once: the ISO text (`toISOString()`) the code puts in its
/// JSON and rows, and the `timestamp` it stores (UTC, milliseconds, as
/// Drizzle wrote it).
pub(crate) fn now_and_stamp() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (
        weldsuite_events::iso_timestamp(at),
        weldsuite_db::utc_timestamp(at),
    )
}

/// `$n::date` of a `YYYY-MM-DD` day, or the failed cast's error.
pub(crate) fn date_of(day: &str) -> Result<Date, DbErr> {
    Date::parse(day, format_description!("[year]-[month]-[day]"))
        .ok()
        .filter(|date| date.year() >= 1)
        .ok_or_else(|| DbErr::Type(format!("invalid input syntax for type date: \"{day}\"")))
}

/// `$n::timestamp` of an ISO instant (`toISOString()`, or a `YYYY-MM-DD`
/// day): Postgres keeps its UTC wall clock and drops the `Z`.
pub(crate) fn timestamp_of(iso: &str) -> Result<PrimitiveDateTime, DbErr> {
    crate::js::js_date_millis(iso)
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

/// `$n::numeric` of a decimal text (`toFixed(2)`): the value with that
/// text's scale, or the failed cast's error.
pub(crate) fn decimal_of(text: &str) -> Result<BigDecimal, DbErr> {
    BigDecimal::from_str(text)
        .map_err(|_| DbErr::Type(format!("invalid input syntax for type numeric: \"{text}\"")))
}

#[cfg(test)]
mod tests {
    use time::macros::{date, datetime};

    use super::*;

    #[test]
    fn values_bind_as_the_casts_read_them() {
        assert_eq!(
            timestamp_of("2026-10-29T07:00:00.123Z").ok(),
            Some(datetime!(2026-10-29 07:00:00.123))
        );
        assert_eq!(
            timestamp_of("2026-10-29").ok(),
            Some(datetime!(2026-10-29 00:00:00))
        );
        assert!(timestamp_of("nope").is_err());
        assert_eq!(date_of("2026-02-28").ok(), Some(date!(2026 - 02 - 28)));
        assert!(date_of("2026-02-30").is_err());
        assert_eq!(
            decimal_of("12.30").ok().map(|d| d.to_plain_string()),
            Some("12.30".to_owned())
        );
    }
}
