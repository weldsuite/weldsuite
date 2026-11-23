//! Writing a request body into a table the way meet-api's Drizzle calls do:
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
//! `timestamp` column (Drizzle's `Date`s, `toISOString()` texts bound as
//! `$n::timestamp`), and a row read through its entity as Drizzle's
//! `select()` returned it.

use sea_orm::DbErr;
use serde_json::{Map, Value};
use time::format_description::well_known::Rfc3339;
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

/// A table meet-api writes from a request body.
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

/// A row read through its entity, as Drizzle's `select()` returned it (the
/// entity serializes as Drizzle did).
pub(crate) fn row_json<M: serde::Serialize>(model: M) -> Result<Value, DbErr> {
    serde_json::to_value(model).map_err(|error| DbErr::Json(error.to_string()))
}

/// `new Date()` as the routes write it: its `toISOString()` text (what
/// [`crate::now`] gives) and the `timestamp` Drizzle stores, the same instant.
pub(crate) fn now_both() -> (String, PrimitiveDateTime) {
    let at = OffsetDateTime::now_utc();
    (iso_timestamp(at), weldsuite_db::utc_timestamp(at))
}

/// A `timestamp` as JavaScript held it once Drizzle read it (a `Date`:
/// milliseconds, the rest truncated), for a keyset condition on the value
/// the route saw.
pub(crate) fn js_instant(at: PrimitiveDateTime) -> PrimitiveDateTime {
    weldsuite_db::utc_timestamp(at.assume_utc())
}

/// A `timestamp` column as `toISOString()` (Drizzle's `Date`).
pub(crate) fn iso(at: PrimitiveDateTime) -> String {
    iso_timestamp(at.assume_utc())
}

/// A `toISOString()` text the route bound as `$n::timestamp`: Postgres
/// reads its date and time and ignores the zone, and refuses text that is no
/// timestamp (the statement's error).
pub(crate) fn sql_timestamp(text: &str) -> Result<PrimitiveDateTime, DbErr> {
    let at = OffsetDateTime::parse(text, &Rfc3339).map_err(|_| {
        DbErr::Custom(format!(
            "invalid input syntax for type timestamp: \"{text}\""
        ))
    })?;
    Ok(PrimitiveDateTime::new(at.date(), at.time()))
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
    fn instants_travel_as_drizzle_wrote_them() {
        let at = sql_timestamp("2026-10-01T12:00:00.123Z").expect("timestamp");
        assert_eq!(iso(at), "2026-10-01T12:00:00.123Z");
        assert_eq!(
            sql_timestamp("2026-10-01T12:00:00.123+02:00").map(iso).ok(),
            Some("2026-10-01T12:00:00.123Z".to_owned())
        );
        assert!(sql_timestamp("not a date").is_err());
        let fine = at + time::Duration::microseconds(456);
        assert_eq!(js_instant(fine), at);
    }
}
