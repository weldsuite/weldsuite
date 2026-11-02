//! Bodies that Drizzle writes as they come (`.passthrough()` schemas spread
//! into `insert().values()` / `update().set()`): every key that names a
//! column is written, whatever its JSON type, the way Drizzle and the driver
//! hand it to Postgres. Keys that are not columns are dropped.
//!
//! - A `timestamp` column maps a value with `toISOString()`: a string (or
//!   anything but `null`) throws a `TypeError`, which the route answers with
//!   its 500.
//! - `jsonb` is `JSON.stringify(value)`.
//! - Everything else goes as text (`String(value)`, a boolean as `true` /
//!   `false`) and Postgres casts it, failing as it does for a fraction in an
//!   integer column.
//! - `null` is SQL `NULL`; a key left out is the column default.

use serde_json::{Map, Value};

use crate::js::{js_string, js_value, truthy};

/// How a column takes a value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Text,
    Integer,
    Boolean,
    Jsonb,
    Timestamp,
}

/// A column value as the driver gets it: absent (default), `NULL`, or text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Column {
    Absent,
    Null,
    Text(String),
}

impl Column {
    pub(crate) fn is_set(&self) -> bool {
        !matches!(self, Self::Absent)
    }

    pub(crate) fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }
}

/// A `toISOString()` on something that is not a `Date`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct NotADate(pub(crate) String);

/// The value of `key` for a column of `kind`.
pub(crate) fn column(
    values: &Map<String, Value>,
    key: &str,
    kind: Kind,
) -> Result<Column, NotADate> {
    let Some(value) = values.get(key) else {
        return Ok(Column::Absent);
    };
    if value.is_null() {
        return Ok(Column::Null);
    }
    Ok(Column::Text(match kind {
        Kind::Timestamp => {
            return Err(NotADate(format!(
                "TypeError: value.toISOString is not a function ({key})"
            )));
        }
        Kind::Jsonb => js_value(value).to_string(),
        Kind::Boolean => truthy(value).to_string(),
        Kind::Text | Kind::Integer => js_string(value),
    }))
}

/// `(set, value)` for `case when $set then $value else <default or col> end`.
pub(crate) fn bind(column: &Column) -> (bool, Option<String>) {
    (column.is_set(), column.text().map(str::to_owned))
}
