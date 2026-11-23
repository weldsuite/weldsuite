//! Reading and writing books tables the way books-api's Drizzle calls do
//! (the same model as `weldsuite-desk-domain`'s): rows as Drizzle returns them
//! (properties, `numeric` as text, `Date`s as `toISOString()`: the table's
//! entity serializes so, and [`Table::js`] turns a `to_jsonb` row into the
//! same), and `db.insert(t).values({ id, ...data })` /
//! `db.update(t).set(data)`, where `data` is what the route's Zod schema let
//! through (`.passthrough()` included: any key that is one of the table's
//! properties reaches the statement). The body becomes a `{ column: value }`
//! JSON object that [`weldsuite_db::record`] writes through the entity, and a
//! column the object leaves out gets its database default (insert) or keeps
//! its value (patch), as Drizzle leaves it out of the statement.
//!
//! The tables are generated in [`crate::tables`] (`tools/tables.mts`).

use sea_orm::{ConnectionTrait, DbErr};
use serde_json::{Map, Value};
use sqlx::PgConnection;
use weldsuite_db::record::JsonTable;
use weldsuite_db::{OrmConn, PgPool, js_timestamp, orm};

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

/// Where [`Table::insert_raw`] and [`Table::patch_raw`] write: the pool, or
/// the connection of a transaction (`&mut *conn` inside `atomically_with`,
/// `&mut *tx`).
pub enum TableDb<'c> {
    Pool(&'c PgPool),
    Conn(&'c mut PgConnection),
}

impl<'c> From<&'c PgPool> for TableDb<'c> {
    fn from(pool: &'c PgPool) -> Self {
        Self::Pool(pool)
    }
}

impl<'c> From<&'c mut PgConnection> for TableDb<'c> {
    fn from(conn: &'c mut PgConnection) -> Self {
        Self::Conn(conn)
    }
}

/// The error of an `atomically_with` transaction whose statements go through
/// the entities: a failed statement, or the transaction's own `BEGIN` /
/// `COMMIT` (an `sqlx::Error`, through `weldsuite_db::orm_error`). `?` turns
/// it back into the `DbErr` (or the route's [`crate::http::Refusal`]).
#[derive(Debug)]
pub struct TxError(pub DbErr);

impl From<DbErr> for TxError {
    fn from(error: DbErr) -> Self {
        Self(error)
    }
}

impl From<sqlx::Error> for TxError {
    fn from(error: sqlx::Error) -> Self {
        Self(weldsuite_db::orm_error(error))
    }
}

impl From<TxError> for DbErr {
    fn from(TxError(error): TxError) -> Self {
        error
    }
}

impl From<TxError> for crate::http::Refusal {
    fn from(TxError(error): TxError) -> Self {
        Self::Database(error)
    }
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

/// For the callers still writing SQL around a [`Table`] write.
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

impl Table {
    /// A `row` (`to_jsonb(t)`) as Drizzle's `select()` returns it: the
    /// schema's property names (`relatedFAQs`, not `relatedFaqs`), `Date`s as
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
        self.check_dates(&values, trusted)?;
        let row = self.entity.insert(&orm(db), values).await?;
        Ok(self.drizzle(row))
    }

    /// Insert values the route built itself (every property trusted, as
    /// Drizzle got JavaScript values), on the pool or on a transaction's
    /// connection. The row as Drizzle returns it.
    pub async fn insert_raw(
        &self,
        db: impl Into<TableDb<'_>>,
        values: Map<String, Value>,
    ) -> Result<Value, DbErr> {
        match db.into() {
            TableDb::Pool(pool) => self.insert_raw_on(&orm(pool), values).await,
            TableDb::Conn(conn) => self.insert_raw_on(&OrmConn::new(conn), values).await,
        }
    }

    /// [`Table::insert_raw`] on a SeaORM connection (`OrmConn` in a
    /// transaction).
    pub async fn insert_raw_on<C: ConnectionTrait>(
        &self,
        db: &C,
        values: Map<String, Value>,
    ) -> Result<Value, DbErr> {
        let row = self.entity.insert(db, values).await?;
        Ok(self.drizzle(row))
    }

    /// [`Table::patch`] with values the route built itself, on the pool or
    /// on a transaction's connection.
    pub async fn patch_raw(
        &self,
        db: impl Into<TableDb<'_>>,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
    ) -> Result<Option<Value>, DbErr> {
        match db.into() {
            TableDb::Pool(pool) => {
                self.patch_raw_on(&orm(pool), id, values, live_only)
                    .await
            }
            TableDb::Conn(conn) => {
                self.patch_raw_on(&OrmConn::new(conn), id, values, live_only)
                    .await
            }
        }
    }

    /// [`Table::patch_raw`] on a SeaORM connection (`OrmConn` in a
    /// transaction).
    pub async fn patch_raw_on<C: ConnectionTrait>(
        &self,
        db: &C,
        id: &str,
        values: Map<String, Value>,
        live_only: bool,
    ) -> Result<Option<Value>, DbErr> {
        let row = self.entity.update(db, id, values, live_only).await?;
        Ok(row.map(|row| self.drizzle(row)))
    }

    /// Rows selected with [`crate::books_row!`] as Drizzle returns them.
    pub fn js_rows(&self, rows: Vec<Value>) -> Vec<Value> {
        rows.into_iter().map(|row| self.js(row)).collect()
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
        self.check_dates(&values, trusted)?;
        let row = self.entity.update(&orm(db), id, values, live_only).await?;
        Ok(row.map(|row| self.drizzle(row)))
    }

    /// The live row `id` (`deleted_at is null` where the table has it), as
    /// Drizzle returns it.
    pub async fn find_live(&self, db: &PgPool, id: &str) -> Result<Option<Value>, DbErr> {
        let row = self.entity.find(&orm(db), id, true).await?;
        Ok(row.map(|row| self.drizzle(row)))
    }

    /// The entity's row as Drizzle returns it for this table: the table's
    /// properties, in its order (a column the entity has and the Drizzle
    /// schema doesn't is left out, as it was of a `to_jsonb` row).
    fn drizzle(&self, row: Value) -> Value {
        let Value::Object(mut row) = row else {
            return row;
        };
        let mut out = Map::with_capacity(self.columns.len());
        for column in self.columns {
            let value = row.remove(column.prop).unwrap_or(Value::Null);
            out.insert(column.prop.to_owned(), value);
        }
        Value::Object(out)
    }
}
