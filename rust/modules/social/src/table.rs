//! Writing a request body into a table the way social-api's Drizzle calls do:
//! `db.insert(t).values({ id, ...data, createdAt, updatedAt })` and
//! `db.update(t).set({ updatedAt, ...data })`, where `data` is what the
//! route's Zod schema let through (`.passthrough()` included: any key that is
//! one of the table's properties reaches the statement).
//!
//! A [`Table`] (generated in `crate::tables`) maps Drizzle's properties onto
//! the columns of its entity; the body becomes a `{ column: value }` JSON
//! object that [`weldsuite_db::record`] writes through the entity, and a
//! column the object leaves out gets its database default (insert) or keeps
//! its value (patch), as Drizzle leaves it out of the statement. The same
//! machinery as WeldDesk's, kept here so the two modules stay independent.
//!
//! Also here: how the routes' instants travel between JavaScript and a
//! `timestamp` column (Drizzle's `Date`s and their `toISOString()` texts).

use sea_orm::DbErr;
use serde_json::{Map, Value};
use time::{OffsetDateTime, PrimitiveDateTime};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, orm};
use weldsuite_events::iso_timestamp;

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

/// A table social-api writes from a request body.
#[derive(Debug, Clone, Copy)]
pub(crate) struct Table {
    pub(crate) name: &'static str,
    /// The table's entity: the statements, and the row as Drizzle returns it.
    pub(crate) entity: JsonTable,
    pub(crate) columns: &'static [Column],
}

/// Why a write could not run.
#[derive(Debug)]
pub(crate) enum WriteError {
    /// A `date`-mode timestamp got a value that is not a `Date`: Drizzle's
    /// `toISOString` throws before the statement runs (the route's 500).
    NotADate(&'static str),
    Database(DbErr),
}

impl From<DbErr> for WriteError {
    fn from(error: DbErr) -> Self {
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
    pub(crate) fn check_dates(
        &self,
        values: &Map<String, Value>,
        trusted: &[&str],
    ) -> Result<(), WriteError> {
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
    pub(crate) async fn insert(
        &self,
        db: &PgPool,
        values: Map<String, Value>,
        trusted: &[&str],
    ) -> Result<Value, WriteError> {
        self.check_dates(&values, trusted)?;
        Ok(self.entity.insert(&orm(db), values).await?)
    }

    /// Update the row `id` with `values`; `live_only` adds `deleted_at is
    /// null`. The changed row, or `None` when none matched.
    pub(crate) async fn patch(
        &self,
        db: &PgPool,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
        trusted: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        self.check_dates(&values, trusted)?;
        Ok(self.entity.update(&orm(db), id, values, live_only).await?)
    }

    /// The live row `id`, as Drizzle returns it.
    pub(crate) async fn find_live(&self, db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
        self.entity.find(&orm(db), id, true).await
    }

    /// The columns this table names that its entity lacks, and the entity's
    /// columns it leaves out: both empty while the two agree.
    #[cfg(test)]
    fn entity_drift(&self) -> (Vec<&'static str>, Vec<&'static str>) {
        let entity = self.entity.columns();
        let missing = self
            .columns
            .iter()
            .map(|column| column.name)
            .filter(|name| !entity.contains(name))
            .collect();
        let extra = entity
            .into_iter()
            .filter(|name| !self.columns.iter().any(|column| column.name == *name))
            .collect();
        (missing, extra)
    }
}

/// `new Date()` as the routes write it: its `toISOString()` text (what
/// [`crate::now`] gives) and the `timestamp` Drizzle stores, the same instant.
pub(crate) fn now_both() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (iso_timestamp(at), weldsuite_db::utc_timestamp(at))
}

/// A `timestamp` column as `toISOString()` (Drizzle's `Date`: milliseconds,
/// the rest truncated).
pub(crate) fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_tables_match_their_entities() {
        for table in crate::tables::ALL {
            assert_eq!(table.entity_drift(), (vec![], vec![]), "{}", table.name);
        }
    }

    #[test]
    fn instants_read_as_javascript_dates() {
        let at = PrimitiveDateTime::new(
            time::macros::date!(2026 - 10 - 01),
            time::macros::time!(12:00:00.123_456),
        );
        assert_eq!(iso(at), "2026-10-01T12:00:00.123Z");
        let (text, stamp) = now_both();
        assert_eq!(iso(stamp), text);
    }
}
