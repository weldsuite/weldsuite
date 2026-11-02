//! Writing a request body into a table the way the routes' Drizzle calls do:
//! `db.insert(t).values({ ...body, id, createdAt, updatedAt })` and
//! `db.update(t).set({ ...body, updatedAt })`, where `body` is what the
//! route's Zod schema let through.
//!
//! The generated tables (`tables_gen.rs`) carry the statements: the values
//! become a `{ column: value }` JSON object, `jsonb_populate_record` turns it
//! into the row, and a column the object leaves out gets its database default
//! (insert) or keeps its value (patch), as Drizzle leaves it out of the
//! statement. (The same scheme as `weldsuite_desk_domain::table`, with the
//! hard delete and the any-row read the public API also needs.)

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
    /// A `$defaultFn` Drizzle runs when the insert leaves the property out.
    #[allow(dead_code)]
    pub(crate) default_fn: bool,
    /// An `$onUpdateFn` Drizzle runs when an update leaves the property out.
    #[allow(dead_code)]
    pub(crate) on_update: bool,
}

/// A table the public API writes.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Table {
    pub(crate) name: &'static str,
    pub(crate) columns: &'static [Column],
    /// Whether the table has `deleted_at` (the routes' soft delete).
    pub(crate) soft_delete: bool,
    /// `$1`: the row as `{ column: value }`. Returns the row.
    pub(crate) insert: &'static str,
    /// `$1`: the changes as `{ column: value }`, `$2`: the id, `$3`: only a
    /// live row (`deleted_at is null`). Returns the row, if one was changed.
    pub(crate) patch: &'static str,
    /// `$1`: the id. The live row (`deleted_at is null` where the table has it).
    pub(crate) select_live: &'static str,
    /// `$1`: the id. The row, removed or not.
    pub(crate) select_any: &'static str,
    /// `$1`: the id. Deletes the row, returning it.
    pub(crate) remove: &'static str,
}

/// A `timestamp` or `date` column read in `date` mode, as `toISOString()`:
/// a `date` (`2026-10-29`) is midnight UTC.
pub(crate) fn js_date(text: &str) -> String {
    if text.len() == 10 {
        return format!("{text}T00:00:00.000Z");
    }
    js_timestamp(text).unwrap_or_else(|| text.to_owned())
}

/// A `timestamp` column in `string` mode, as Postgres prints it
/// (`2026-10-29 07:00:00+00`), where `to_jsonb` writes ISO.
fn pg_text_timestamp(text: &str) -> String {
    if text.len() <= 10 || text.as_bytes().get(10) != Some(&b'T') {
        return text.to_owned();
    }
    let out = text.replacen('T', " ", 1);
    match out.strip_suffix("+00:00") {
        Some(stripped) => format!("{stripped}+00"),
        None => out,
    }
}

/// Why a write could not run.
#[derive(Debug)]
pub(crate) enum WriteError {
    /// A `date`-mode timestamp got a value that is not a `Date`: Drizzle's
    /// `toISOString` throws before the statement runs (the route's 500).
    NotADate(&'static str),
    /// `set({})`: Drizzle throws `No values to set` (the route's 500).
    NoValues,
    Database(sqlx::Error),
}

impl From<sqlx::Error> for WriteError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl Table {
    /// A row (`to_jsonb(t)`) as Drizzle's `select()` returns it: the
    /// schema's property names, `Date`s as `toISOString()`, and only the
    /// schema's columns, in its order.
    pub(crate) fn js(&self, row: Value) -> Value {
        let Value::Object(mut row) = row else {
            return row;
        };
        let mut out = Map::with_capacity(self.columns.len());
        for column in self.columns {
            let value = row.remove(column.name).unwrap_or(Value::Null);
            let value = match (column.kind, value) {
                (Kind::Date, Value::String(text)) => Value::String(js_date(&text)),
                (Kind::DateString, Value::String(text)) => Value::String(pg_text_timestamp(&text)),
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

    /// The `date`-mode timestamps in `values` that are not `Date`s: a
    /// string there makes Drizzle throw. `dates` names the properties that
    /// hold one (the route's own values, a `z.coerce.date()` field).
    fn check_dates(&self, values: &Map<String, Value>, dates: &[&str]) -> Result<(), WriteError> {
        for column in self.columns {
            if column.kind == Kind::Date
                && !dates.contains(&column.prop)
                && values.get(column.name).is_some_and(|v| !v.is_null())
            {
                return Err(WriteError::NotADate(column.prop));
            }
        }
        Ok(())
    }

    /// Insert `data` (by property); `dates` names the properties holding a
    /// `Date`. The row as Drizzle returns it.
    pub(crate) async fn insert<'e>(
        &self,
        db: impl sqlx::PgExecutor<'e>,
        data: &Map<String, Value>,
        dates: &[&str],
    ) -> Result<Value, WriteError> {
        let values = self.values(data);
        self.check_dates(&values, dates)?;
        let row: Value = sqlx::query_scalar(self.insert)
            .bind(Value::Object(values))
            .fetch_one(db)
            .await?;
        Ok(self.js(row))
    }

    /// Update the row `id` with `data` (by property); `live_only` adds
    /// `deleted_at is null`. The changed row, or `None` when none matched.
    pub(crate) async fn patch<'e>(
        &self,
        db: impl sqlx::PgExecutor<'e>,
        id: &str,
        data: &Map<String, Value>,
        live_only: bool,
        dates: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        let values = self.values(data);
        if values.is_empty() {
            return Err(WriteError::NoValues);
        }
        self.check_dates(&values, dates)?;
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

    /// The row `id`, removed or not.
    pub(crate) async fn find_any(
        &self,
        db: &PgPool,
        id: &str,
    ) -> Result<Option<Value>, sqlx::Error> {
        let row: Option<Value> = sqlx::query_scalar(self.select_any)
            .bind(id)
            .fetch_optional(db)
            .await?;
        Ok(row.map(|row| self.js(row)))
    }

    /// Delete the row `id`; the deleted row, if there was one.
    pub(crate) async fn delete(&self, db: &PgPool, id: &str) -> Result<Option<Value>, sqlx::Error> {
        let row: Option<Value> = sqlx::query_scalar(self.remove)
            .bind(id)
            .fetch_optional(db)
            .await?;
        Ok(row.map(|row| self.js(row)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn string_timestamps_print_as_postgres() {
        assert_eq!(
            pg_text_timestamp("2026-10-29T07:00:00+00:00"),
            "2026-10-29 07:00:00+00"
        );
        assert_eq!(
            pg_text_timestamp("2026-10-29T07:00:00"),
            "2026-10-29 07:00:00"
        );
        assert_eq!(pg_text_timestamp("2026-10-29"), "2026-10-29");
    }
}
