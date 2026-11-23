//! Writing a request body into a table the way desk-api's Drizzle calls do:
//! `db.insert(t).values({ id, ...data, createdAt, updatedAt })` and
//! `db.update(t).set({ updatedAt, ...data })`, where `data` is what the
//! route's Zod schema let through (`.passthrough()` included: any key that is
//! one of the table's properties reaches the statement).
//!
//! A [`Table`] maps Drizzle's properties onto the columns of its entity; the
//! body becomes a `{ column: value }` JSON object that
//! [`weldsuite_db::record`] writes through the entity, and a column the object
//! leaves out gets its database default (insert) or keeps its value (patch),
//! as Drizzle leaves it out of the statement.
//!
//! Here rather than in the desk crate because the webchat inbox's writer
//! ([`crate::webchat::append_desk_message`]) is shared with the helpdesk
//! widget API.

use sea_orm::{ConnectionTrait, DbErr};
use serde_json::{Map, Value};
use weldsuite_db::record::JsonTable;
use weldsuite_db::{PgPool, js_timestamp, orm};

/// How Drizzle maps a property's value onto its column.
#[allow(dead_code)] // every Drizzle kind the generator writes
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
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
pub struct Column {
    /// The Drizzle property (`ticketTypeId`).
    pub prop: &'static str,
    /// The column (`ticket_type_id`).
    pub name: &'static str,
    pub kind: Kind,
    #[allow(dead_code)] // none of the tables has one yet
    /// A `$defaultFn` Drizzle runs when the insert leaves the property out.
    pub default_fn: bool,
}

/// A table desk-api writes from a request body.
#[derive(Debug, Clone, Copy)]
pub struct Table {
    pub name: &'static str,
    /// The table's entity: the statements, and the row as Drizzle returns it.
    pub entity: JsonTable,
    pub columns: &'static [Column],
}

/// A `timestamp` or `date` column read in `date` mode, as `toISOString()`:
/// a `date` (`2026-10-29`) is midnight UTC.
pub fn js_date(text: &str) -> String {
    if text.len() == 10 {
        return format!("{text}T00:00:00.000Z");
    }
    js_timestamp(text).unwrap_or_else(|| text.to_owned())
}

/// Why a write could not run.
#[derive(Debug)]
pub enum WriteError {
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

/// For the callers still writing SQL around a [`Table`] write (the desk
/// crate, until its queries move to the entities).
impl From<sqlx::Error> for WriteError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(weldsuite_db::orm_error(error))
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

impl WriteError {
    /// A Postgres unique violation (`23505`), of `constraint` when given.
    pub fn is_unique_violation(&self, constraint: Option<&str>) -> bool {
        let Self::Database(error) = self else {
            return false;
        };
        weldsuite_db::is_unique_violation(error)
            && constraint.is_none_or(|c| weldsuite_db::pg_constraint(error).as_deref() == Some(c))
    }
}

impl Table {
    /// A `to_jsonb(t)` row as Drizzle's `select()` returns it: the schema's
    /// property names (`relatedFAQs`, not `relatedFaqs`), `Date`s as
    /// `toISOString()`, and only the schema's columns.
    pub fn js(&self, row: Value) -> Value {
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

    pub fn column(&self, prop: &str) -> Option<&'static Column> {
        self.columns.iter().find(|c| c.prop == prop)
    }

    /// `{ ...data }` as `{ column: value }`: the properties of the table in
    /// `data`, in `data`'s order. Keys that are not properties are dropped,
    /// as Drizzle drops them.
    pub fn values(&self, data: &Map<String, Value>) -> Map<String, Value> {
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
    pub fn set(&self, values: &mut Map<String, Value>, prop: &str, value: Value) {
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
    pub async fn insert(
        &self,
        db: &PgPool,
        values: Map<String, Value>,
        trusted: &[&str],
    ) -> Result<Value, WriteError> {
        self.insert_on(&orm(db), values, trusted).await
    }

    /// [`Table::insert`] on a SeaORM connection (`OrmConn` in a transaction).
    pub async fn insert_on<C: ConnectionTrait>(
        &self,
        db: &C,
        values: Map<String, Value>,
        trusted: &[&str],
    ) -> Result<Value, WriteError> {
        self.check_dates(&values, trusted)?;
        Ok(self.entity.insert(db, values).await?)
    }

    /// Update the row `id` with `values`; `live_only` adds `deleted_at is
    /// null`. The changed row, or `None` when none matched.
    pub async fn patch(
        &self,
        db: &PgPool,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
        trusted: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        self.patch_on(&orm(db), id, values, live_only, trusted)
            .await
    }

    /// [`Table::patch`] on a SeaORM connection (`OrmConn` in a transaction).
    pub async fn patch_on<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
        trusted: &[&str],
    ) -> Result<Option<Value>, WriteError> {
        self.check_dates(&values, trusted)?;
        Ok(self.entity.update(db, id, values, live_only).await?)
    }

    /// The columns this table names that its entity lacks, and the entity's
    /// columns it leaves out: both empty while the two agree.
    pub fn entity_drift(&self) -> (Vec<&'static str>, Vec<&'static str>) {
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

    /// The live row `id` (`deleted_at is null` where the table has it), as
    /// Drizzle returns it.
    pub async fn find_live(&self, db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
        self.entity.find(&orm(db), id, true).await
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_tables_match_their_entities() {
        for table in [
            &crate::webchat::DESK_CONVERSATIONS,
            &crate::webchat::DESK_MESSAGES,
            &crate::webchat::DESK_VISITORS,
            &crate::catalog::DESK_CATALOG_ITEMS,
            &crate::catalog::DESK_REQUEST_APPROVALS,
            &crate::problems::DESK_PROBLEMS,
        ] {
            assert_eq!(table.entity_drift(), (vec![], vec![]), "{}", table.name);
        }
    }
}
