//! Writing a request body into a table the way social-api's Drizzle calls do:
//! `db.insert(t).values({ id, ...data, createdAt, updatedAt })` and
//! `db.update(t).set({ updatedAt, ...data })`, where `data` is what the
//! route's Zod schema let through (`.passthrough()` included: any key that is
//! one of the table's properties reaches the statement).
//!
//! The generated tables (`crate::tables`) carry the statements: the body
//! becomes a `{ column: value }` JSON object, `jsonb_populate_record` turns it
//! into the row, and a column the object leaves out gets its database
//! default (insert) or keeps its value (patch), as Drizzle leaves it out of
//! the statement. The same machinery as WeldDesk's (`weldsuite-desk-domain`),
//! kept here so the two modules stay independent.

use serde_json::{Map, Value};
use weldsuite_db::{PgPool, js_timestamp};

/// How Drizzle maps a property's value onto its column.
#[allow(dead_code)] // every Drizzle kind the generator writes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Kind {
    Text,
    Number,
    Bool,
    Json,
    /// `timestamp` / `date` in `date` mode: Drizzle calls `value.toISOString()`,
    /// so anything but a `Date` (or null) makes the statement throw.
    Date,
    /// `timestamp` / `date` in `string` mode.
    DateString,
    /// `numeric`: read back as a string.
    Numeric,
    Array,
    Other,
}

/// A table property.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Column {
    /// The Drizzle property (`ticketTypeId`).
    pub(crate) prop: &'static str,
    /// The column (`ticket_type_id`).
    pub(crate) name: &'static str,
    pub(crate) kind: Kind,
    #[allow(dead_code)] // none of the tables has one yet
    /// A `$defaultFn` Drizzle runs when the insert leaves the property out.
    pub(crate) default_fn: bool,
}

/// A table desk-api writes from a request body.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Table {
    pub(crate) name: &'static str,
    pub(crate) columns: &'static [Column],
    /// The row as Drizzle returns it, before [`js_row`]: `to_jsonb(t)`, with
    /// `numeric` columns as text.
    #[allow(dead_code)]
    pub(crate) row: &'static str,
    /// `$1`: the row as `{ column: value }`. Returns the row.
    pub(crate) insert: &'static str,
    /// `$1`: the changes as `{ column: value }`, `$2`: the id, `$3`: only a
    /// live row (`deleted_at is null`). Returns the row, if one was changed.
    pub(crate) patch: &'static str,
    /// `$1`: the id. The live row (`deleted_at is null` where the table has it).
    pub(crate) select_live: &'static str,
}

/// A `timestamp` or `date` column read in `date` mode, as `toISOString()`:
/// a `date` (`2026-10-29`) is midnight UTC.
pub(crate) fn js_date(text: &str) -> String {
    if text.len() == 10 {
        return format!("{text}T00:00:00.000Z");
    }
    js_timestamp(text).unwrap_or_else(|| text.to_owned())
}

/// Why a write could not run.
#[derive(Debug)]
pub(crate) enum WriteError {
    /// A `date`-mode timestamp got a value that is not a `Date`: Drizzle's
    /// `toISOString` throws before the statement runs (the route's 500).
    NotADate(&'static str),
    Database(sqlx::Error),
}

impl From<sqlx::Error> for WriteError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl std::fmt::Display for WriteError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotADate(prop) => write!(f, "value.toISOString is not a function ({prop})"),
            Self::Database(error) => error.fmt(f),
        }
    }
}

impl Table {
    /// A `row` (`to_jsonb(t)`) as Drizzle's `select()` returns it: the
    /// schema's property names (`relatedFAQs`, not `relatedFaqs`), `Date`s as
    /// `toISOString()`, and only the schema's columns.
    pub(crate) fn js(&self, row: Value) -> Value {
        let Value::Object(mut row) = row else {
            return row;
        };
        let mut out = Map::with_capacity(self.columns.len());
        for column in self.columns {
            let value = row.remove(column.name).unwrap_or(Value::Null);
            let value = match (column.kind, value) {
                (Kind::Date, Value::String(text)) => Value::String(js_date(&text)),
                (_, value) => value,
            };
            out.insert(column.prop.to_owned(), value);
        }
        Value::Object(out)
    }

    pub(crate) fn column(&self, prop: &str) -> Option<&'static Column> {
        self.columns.iter().find(|c| c.prop == prop)
    }

    /// `{ ...data }` as `{ column: value }`: the properties of the table in
    /// `data`, in `data`'s order. Keys that are not properties are dropped,
    /// as Drizzle drops them.
    pub(crate) fn values(&self, data: &Map<String, Value>) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, value) in data {
            if let Some(column) = self.column(key) {
                out.insert(column.name.to_owned(), value.clone());
            }
        }
        out
    }

    /// Set a property the route writes itself (`createdAt: now`). Values the
    /// route builds are what Drizzle got as JavaScript values (a `Date` for a
    /// timestamp), so they are not checked.
    pub(crate) fn set(&self, values: &mut Map<String, Value>, prop: &str, value: Value) {
        if let Some(column) = self.column(prop) {
            values.insert(column.name.to_owned(), value);
        }
    }

    /// The `date`-mode timestamps in `values` that came from the body: a
    /// string there makes Drizzle throw.
    fn check_dates(&self, values: &Map<String, Value>, trusted: &[&str]) -> Result<(), WriteError> {
        for column in self.columns {
            if column.kind == Kind::Date
                && !trusted.contains(&column.prop)
                && values.get(column.name).is_some_and(|v| !v.is_null())
            {
                return Err(WriteError::NotADate(column.prop));
            }
        }
        Ok(())
    }

    /// Insert `values` (see [`Table::values`]); `trusted` names the
    /// properties the route set itself. The row as Drizzle returns it.
    pub(crate) async fn insert<'e>(
        &self,
        db: impl sqlx::PgExecutor<'e>,
        values: Map<String, Value>,
        trusted: &[&str],
    ) -> Result<Value, WriteError> {
        self.check_dates(&values, trusted)?;
        let row: Value = sqlx::query_scalar(self.insert)
            .bind(Value::Object(values))
            .fetch_one(db)
            .await?;
        Ok(self.js(row))
    }

    /// Update the row `id` with `values`; `live_only` adds `deleted_at is
    /// null`. The changed row, or `None` when none matched.
    pub(crate) async fn patch<'e>(
        &self,
        db: impl sqlx::PgExecutor<'e>,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
        trusted: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        self.check_dates(&values, trusted)?;
        let row: Option<Value> = sqlx::query_scalar(self.patch)
            .bind(Value::Object(values))
            .bind(id)
            .bind(live_only)
            .fetch_optional(db)
            .await?;
        Ok(row.map(|row| self.js(row)))
    }

    /// The live row `id`, as Drizzle returns it.
    pub(crate) async fn find_live(
        &self,
        db: &PgPool,
        id: &str,
    ) -> Result<Option<Value>, sqlx::Error> {
        let row: Option<Value> = sqlx::query_scalar(self.select_live)
            .bind(id)
            .fetch_optional(db)
            .await?;
        Ok(row.map(|row| self.js(row)))
    }
}
