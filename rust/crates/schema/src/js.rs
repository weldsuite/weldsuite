//! Column values as Drizzle handed them to the TypeScript routes, so a row
//! serializes to the JSON those routes returned (see
//! `weldsuite_db::js_row`, which does the same at run time for `to_jsonb`
//! rows). Each module is a serde `with` target, with an `option` twin for
//! nullable columns.
//!
//! - `timestamp` / `timestamptz` (Drizzle's default `mode: 'date'`): a JS
//!   `Date`, so `toISOString()`: UTC, milliseconds (truncated), `Z`.
//! - `timestamp_text` / `timestamptz_text` (`mode: 'string'`): Postgres's own
//!   text, as the driver returned it.
//! - `date` (`mode: 'string'`, the default): `2026-10-29`;
//!   `date_as_timestamp` (`mode: 'date'`): midnight UTC as `toISOString()`.
//! - `numeric`: a string with the column's scale, as Postgres prints it.
//! - `bigint` (`mode: 'bigint'`): a string, since JSON has no 64-bit integer.

// The submodules are serde `with` targets over the helpers above.
#![allow(clippy::wildcard_imports)]

use serde::Serializer;
use time::macros::format_description;
use time::{Date, OffsetDateTime, PrimitiveDateTime, UtcOffset};

/// `Date#toISOString()` for a UTC wall-clock time.
fn iso(at: PrimitiveDateTime) -> String {
    let millis = at.millisecond();
    format!(
        "{}.{millis:03}Z",
        at.format(format_description!(
            "[year]-[month]-[day]T[hour]:[minute]:[second]"
        ))
        .unwrap_or_default()
    )
}

/// Postgres's text for a timestamp: microseconds with trailing zeros cut, no
/// fraction when it is zero.
fn pg_text(at: PrimitiveDateTime) -> String {
    let base = at
        .format(format_description!(
            "[year]-[month]-[day] [hour]:[minute]:[second]"
        ))
        .unwrap_or_default();
    let micros = at.microsecond();
    if micros == 0 {
        return base;
    }
    let fraction = format!("{micros:06}");
    format!("{base}.{}", fraction.trim_end_matches('0'))
}

fn utc(at: OffsetDateTime) -> PrimitiveDateTime {
    let at = at.to_offset(UtcOffset::UTC);
    PrimitiveDateTime::new(at.date(), at.time())
}

macro_rules! with_option {
    ($ty:ty, $to:expr) => {
        pub fn serialize<S: Serializer>(value: &$ty, serializer: S) -> Result<S::Ok, S::Error> {
            #[allow(clippy::redundant_closure_call)]
            serializer.serialize_str(&($to)(value))
        }

        pub mod option {
            use super::*;

            #[allow(clippy::ref_option)]
            pub fn serialize<S: Serializer>(
                value: &Option<$ty>,
                serializer: S,
            ) -> Result<S::Ok, S::Error> {
                match value {
                    #[allow(clippy::redundant_closure_call)]
                    Some(value) => serializer.serialize_str(&($to)(value)),
                    None => serializer.serialize_none(),
                }
            }
        }
    };
}

pub mod timestamp {
    use super::*;
    with_option!(PrimitiveDateTime, |at: &PrimitiveDateTime| iso(*at));
}

pub mod timestamptz {
    use super::*;
    with_option!(OffsetDateTime, |at: &OffsetDateTime| iso(utc(*at)));
}

pub mod timestamp_text {
    use super::*;
    with_option!(PrimitiveDateTime, |at: &PrimitiveDateTime| pg_text(*at));
}

pub mod timestamptz_text {
    use super::*;
    // The connections run in UTC, so Postgres prints `+00`.
    with_option!(OffsetDateTime, |at: &OffsetDateTime| format!(
        "{}+00",
        pg_text(utc(*at))
    ));
}

pub mod date {
    use super::*;
    with_option!(Date, |day: &Date| day
        .format(format_description!("[year]-[month]-[day]"))
        .unwrap_or_default());
}

pub mod date_as_timestamp {
    use super::*;
    with_option!(Date, |day: &Date| iso(day.midnight()));
}

/// An unconstrained `numeric`: Postgres prints the scale the value was
/// written with, which sqlx doesn't keep, so print it without trailing zeros
/// (what a value written from a JS number has).
pub mod numeric {
    use sea_orm::prelude::BigDecimal;

    use super::*;
    with_option!(BigDecimal, |n: &BigDecimal| n
        .normalized()
        .to_plain_string());
}

/// `numeric(p, S)`: Postgres prints exactly `S` decimals. sqlx decodes the
/// value with a scale rounded up to its base-10000 digit groups (`1.50` →
/// `1.5000`), so the declared scale is applied here. A serde
/// `serialize_with` target: `crate::js::Numeric::<2>::serialize`.
pub struct Numeric<const S: i64>;

impl<const S: i64> Numeric<S> {
    pub fn serialize<Z: Serializer>(
        value: &sea_orm::prelude::BigDecimal,
        serializer: Z,
    ) -> Result<Z::Ok, Z::Error> {
        serializer.serialize_str(&value.with_scale(S).to_plain_string())
    }

    #[allow(clippy::ref_option)]
    pub fn serialize_option<Z: Serializer>(
        value: &Option<sea_orm::prelude::BigDecimal>,
        serializer: Z,
    ) -> Result<Z::Ok, Z::Error> {
        match value {
            Some(value) => Self::serialize(value, serializer),
            None => serializer.serialize_none(),
        }
    }
}

/// `real`: Postgres prints a float4 at its shortest (`1.1`) and JS reads
/// that as a double, so widen through the text, not the bits
/// (`1.100000023841858`).
pub mod real {
    use serde::Serialize;

    use super::*;

    fn double(value: f32) -> f64 {
        value.to_string().parse().unwrap_or(f64::from(value))
    }

    pub fn serialize<S: Serializer>(value: &f32, serializer: S) -> Result<S::Ok, S::Error> {
        double(*value).serialize(serializer)
    }

    pub mod option {
        use super::*;

        #[allow(clippy::ref_option)]
        pub fn serialize<S: Serializer>(
            value: &Option<f32>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            value.map(double).serialize(serializer)
        }
    }
}

/// `numeric` with `mode: 'number'`: a JS number.
pub mod numeric_number {
    use sea_orm::prelude::BigDecimal;
    use serde::Serialize;

    use super::*;

    fn number(n: &BigDecimal) -> f64 {
        n.to_plain_string().parse().unwrap_or(f64::NAN)
    }

    pub fn serialize<S: Serializer>(value: &BigDecimal, serializer: S) -> Result<S::Ok, S::Error> {
        number(value).serialize(serializer)
    }

    pub mod option {
        use super::*;

        #[allow(clippy::ref_option)]
        pub fn serialize<S: Serializer>(
            value: &Option<BigDecimal>,
            serializer: S,
        ) -> Result<S::Ok, S::Error> {
            value.as_ref().map(number).serialize(serializer)
        }
    }
}

pub mod bigint {
    use super::*;
    with_option!(i64, |n: &i64| n.to_string());
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::str::FromStr;

    use sea_orm::prelude::BigDecimal;
    use time::macros::{date, datetime};

    use super::*;

    #[test]
    fn values_read_like_drizzle_values() {
        assert_eq!(
            iso(datetime!(2026-10-29 07:00:00.123_456)),
            "2026-10-29T07:00:00.123Z"
        );
        assert_eq!(
            iso(datetime!(2026-10-29 07:00:00)),
            "2026-10-29T07:00:00.000Z"
        );
        assert_eq!(
            iso(utc(datetime!(2026-10-29 07:46:43.102 +01:00))),
            "2026-10-29T06:46:43.102Z"
        );
        assert_eq!(
            pg_text(datetime!(2026-10-29 07:00:00)),
            "2026-10-29 07:00:00"
        );
        assert_eq!(
            pg_text(datetime!(2026-10-29 07:00:00.120)),
            "2026-10-29 07:00:00.12"
        );
        assert_eq!(
            iso(date!(2026 - 10 - 29).midnight()),
            "2026-10-29T00:00:00.000Z"
        );
        assert_eq!(
            BigDecimal::from_str("1.50").unwrap().to_plain_string(),
            "1.50"
        );
        assert_eq!(
            BigDecimal::from_str("1000000000000000000000000000000.5")
                .unwrap()
                .to_plain_string(),
            "1000000000000000000000000000000.5"
        );
    }
}
